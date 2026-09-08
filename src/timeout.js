export class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "TimeoutError";
  }
}

export function withTimeout(operation, timeoutMilliseconds, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new TimeoutError(message)),
      timeoutMilliseconds,
    );
  });

  return Promise.race([Promise.resolve(operation), timeout]).finally(() => {
    clearTimeout(timeoutId);
  });
}
