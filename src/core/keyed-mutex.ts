export class KeyedMutex {
  private readonly queues = new Map<string, Promise<unknown>>()

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const next = previous.then(work, work)

    const settled = next.then(
      () => undefined,
      () => undefined,
    )
    this.queues.set(key, settled)

    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key)
    })

    return next
  }

  get held(): number {
    return this.queues.size
  }
}
