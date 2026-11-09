// Prisma returns BigInt for sequence columns; JSON.stringify cannot serialise BigInt and would 500 every
// transaction response. Sequences are small ordering counters, so a decimal string is the right wire format.
declare global {
  interface BigInt {
    toJSON(): string;
  }
}
if (!('toJSON' in BigInt.prototype)) {
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value: function toJSON(this: bigint) {
      return this.toString();
    },
    configurable: true,
  });
}
export {};
