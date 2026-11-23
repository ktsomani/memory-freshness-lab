export const LOOKUP_BUDGET_MS = 1200

export function recognizeQuestion(text, field) {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const target = field.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.at(-1)
  if (!target || !words.includes(target)) return null
  const phrase = words.join(" ")
  if (/\b(previous|prior|old|before|formerly|used to)\b/.test(phrase)) return "historical"
  if (/\b(current|currently|now|what is|which is)\b/.test(phrase)) return "current"
  return null
}

/** A scripted call. The caller scopes a lookup to a turn and emits audio only for a valid turn. */
export class VoiceCall {
  #fixture
  #policy
  #budget
  #clock
  #lookup
  #emit
  #changed = false
  #closed = false
  #active
  #sequence = 0

  constructor({ fixture, policy, lookup, emit = () => {}, budgetMs = LOOKUP_BUDGET_MS, clock = performance }) {
    if (!["frozen", "turn-lookup"].includes(policy)) throw new Error("Unknown memory policy.")
    this.#fixture = fixture
    this.#policy = policy
    this.#lookup = lookup
    this.#emit = emit
    this.#budget = budgetMs
    this.#clock = clock
    this.#event("call-start")
  }

  get changed() { return this.#changed }

  #event(type, details = {}) {
    this.#emit({ type, atMs: this.#clock.now(), ...details })
  }

  correct() {
    if (this.#closed || this.#changed) return
    this.#changed = true
    this.interrupt("correction")
    this.#event("correction", { value: this.#fixture.correction })
  }

  interrupt(reason = "caller-interruption") {
    if (!this.#active) return
    const { controller, id } = this.#active
    this.#active = undefined
    controller.abort()
    this.#event("turn-interrupted", { id, reason })
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    this.interrupt("hang-up")
    this.#event("call-ended")
  }

  async ask(question, { slow = false } = {}) {
    if (this.#closed) throw new Error("Call has ended.")
    if (!["current", "historical"].includes(question)) throw new Error("Unknown question.")
    this.interrupt("new-turn")
    const id = ++this.#sequence
    const controller = new AbortController()
    this.#active = { id, controller }
    const began = this.#clock.now()
    this.#event("speech-finalized", { id, question })
    let evidence, outcome
    try {
      if (this.#policy === "frozen" && question === "current") {
        evidence = this.#fixture.before
        outcome = "call-start-profile"
      } else {
        this.#event("lookup-start", { id, question })
        const result = await this.#boundedLookup(question, slow, controller.signal)
        if (this.#active?.id !== id) return null
        evidence = result.evidence
        outcome = result.outcome
        this.#event("lookup-ended", {
          id, outcome, elapsedMs: this.#clock.now() - began, remainingReads: evidence?.remainingReads,
        })
      }
      if (this.#active?.id !== id) return null
      const value = evidence?.value ?? null
      const spoken = value
        ? question === "historical"
          ? `Your previous ${this.#fixture.field} was ${value}.`
          : `Your current ${this.#fixture.field} is ${value}.`
        : `I couldn't verify your ${this.#fixture.field} yet. Can you confirm it?`
      const decision = { id, question, evidence, outcome, value, spoken, decisionMs: this.#clock.now() - began }
      this.#event("answer-ready", { id, value, outcome, decisionMs: decision.decisionMs })
      return decision
    } finally {
      if (this.#active?.id === id) this.#active = undefined
    }
  }

  async #boundedLookup(question, slow, signal) {
    if (signal.aborted) return { outcome: "interrupted" }
    return await new Promise((resolve) => {
      const lookupController = new AbortController()
      const finish = (result) => {
        clearTimeout(timer)
        signal.removeEventListener("abort", abort)
        resolve(result)
      }
      const abort = () => {
        lookupController.abort()
        finish({ outcome: "interrupted" })
      }
      const timer = setTimeout(() => {
        lookupController.abort()
        finish({ outcome: "deadline" })
      }, this.#budget)
      signal.addEventListener("abort", abort, { once: true })
      Promise.resolve().then(() => this.#lookup({
        question, changed: this.#changed, slow, signal: lookupController.signal,
      })).then(
        (evidence) => finish({ outcome: evidence?.value ? "turn-lookup" : "unverified", evidence }),
        () => finish({ outcome: "lookup-error" }),
      )
    })
  }
}

export function createArchivedLookup(fixture, budgetMs = LOOKUP_BUDGET_MS) {
  return ({ question, changed, slow, signal }) => {
    const snapshot = question === "historical" ? (changed ? fixture.history : null)
      : changed ? fixture.after : fixture.before
    return new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer)
        reject(new Error("Lookup was interrupted."))
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort)
        resolve(snapshot)
      }, slow ? budgetMs + 500 : snapshot?.latencyMs ?? 0)
      if (signal.aborted) abort()
      else signal.addEventListener("abort", abort, { once: true })
    })
  }
}
