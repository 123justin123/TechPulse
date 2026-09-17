import cron from "node-cron";

export type Environment = Record<string, string | undefined>;

export interface EnvReader {
  readonly problems: string[];
  optional(name: string): string | undefined;
  required(name: string, reason: string): string;
  oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T | undefined;
  integer(name: string, fallback: number, min: number, max?: number): number;
  list(name: string): string[];
  cron(name: string, fallback: string): string;
}

export function createEnvReader(env: Environment): EnvReader {
  const problems: string[] = [];

  const optional = (name: string): string | undefined => env[name]?.trim() || undefined;

  const required = (name: string, reason: string): string => {
    const value = optional(name);
    if (!value) problems.push(`${name} is required: ${reason}.`);
    return value ?? "";
  };

  return {
    problems,
    optional,
    required,

    oneOf(name, allowed, fallback) {
      const value = optional(name) ?? fallback;
      if ((allowed as readonly string[]).includes(value)) return value as (typeof allowed)[number];
      problems.push(`${name} is "${value}"; allowed values: ${allowed.join(", ")}.`);
      return undefined;
    },

    integer(name, fallback, min, max) {
      const raw = optional(name);
      if (raw === undefined) return fallback;
      const value = Number(raw);
      if (Number.isInteger(value) && value >= min && (max === undefined || value <= max)) return value;
      const range = max === undefined ? `greater than or equal to ${min}` : `between ${min} and ${max}`;
      problems.push(`${name} must be an integer ${range} (got "${raw}").`);
      return fallback;
    },

    list(name) {
      return (optional(name) ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    },

    cron(name, fallback) {
      const value = optional(name) ?? fallback;
      if (!cron.validate(value)) problems.push(`${name} is not a valid cron expression ("${value}").`);
      return value;
    },
  };
}
