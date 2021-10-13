// basic logger with timestamps
export function log(...args: any[]) {
    console.log('\u001b[7m', new Date().toISOString(), '\u001b[0m', '\u001b[7m', 'i', '\u001b[0m', ...args);
}

export function warn(...args: any[]) {
    console.warn('\u001b[7m', new Date().toISOString(), '\u001b[0m', '\u001b[7m', '!', '\u001b[0m', ...args);
}

export function error(...args: any[]) {
    console.warn('\u001b[7m', new Date().toISOString(), '\u001b[0m', '\u001b[7m', '!!', '\u001b[0m', ...args);
}
