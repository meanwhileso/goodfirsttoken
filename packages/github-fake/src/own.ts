// The fake keeps its state in plain objects, keyed by names a request gives:
// tokens, logins, repos, apps, codes, branches, and git object IDs. A name
// like __proto__ or constructor would read what every object inherits, and
// a write through what it read would reach Object.prototype. So every read
// by a requested name takes the object's own properties only, and a write
// makes an own property, whatever the name.

export function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

export function setOwn<T>(map: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(map, key, { value, writable: true, enumerable: true, configurable: true });
}
