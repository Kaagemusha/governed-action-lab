import { createHash } from "node:crypto";

function canonicalValue(value: unknown, path: string): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Non-finite number at ${path}.`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalValue(item, `${path}.${index}`)).join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Non-plain object at ${path}.`);
    }
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => {
        if (item === undefined) {
          throw new TypeError(`Undefined value at ${path}.${key}.`);
        }
        return `${JSON.stringify(key)}:${canonicalValue(item, `${path}.${key}`)}`;
      })
      .join(",")}}`;
  }
  throw new TypeError(`Non-JSON value at ${path}.`);
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value, "root");
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function digestOmitting<T extends Record<string, unknown>>(
  value: T,
  omittedKey: keyof T,
): string {
  const payload = { ...value };
  delete payload[omittedKey];
  return sha256(payload);
}
