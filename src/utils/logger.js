export function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

export function error(...args) {
  console.error(`[${new Date().toISOString()}] [ERROR]`, ...args);
}
