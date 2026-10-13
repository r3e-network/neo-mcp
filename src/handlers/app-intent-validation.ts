import Ajv, { type AnySchema, type ErrorObject } from 'ajv';
import Ajv2019 from 'ajv/dist/2019';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

type RecordValue = Record<string, unknown>;
type IntentError = { code: string; field: string; message: string };

// Snapshot before any await; reject values JSON would silently drop or coerce.
export function snapshotIntentParams(value: unknown): RecordValue {
  let nodes = 0;
  function visit(item: unknown, depth: number): unknown {
    if (++nodes > 2048 || depth > 16) throw new Error('params_too_complex');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return Array.from(item, (entry) => visit(entry, depth + 1));
    if (item && typeof item === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry, depth + 1)]));
    }
    throw new Error('params_must_be_json');
  }
  try {
    const params = value === undefined ? {} : visit(value, 0);
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('params_must_be_object');
    if (Object.keys(params).length > 32 || Buffer.byteLength(JSON.stringify(params)) > 16384) throw new Error('params_too_large');
    return params as RecordValue;
  } catch {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'params must be a bounded JSON object.');
  }
}

function schemaError(error: ErrorObject): IntentError {
  const field = error.keyword === 'required'
    ? `${error.instancePath}/${String(error.params.missingProperty)}`
    : error.instancePath;
  return { code: error.keyword === 'required' ? 'missing_parameter' : 'invalid_parameter', field, message: error.message || 'Parameter does not satisfy input_schema.' };
}

export function validateIntentParams(capability: RecordValue, params: RecordValue): { missing: string[]; errors: IntentError[] } {
  const errors: IntentError[] = [];
  const missing: string[] = [];
  const legacy = capability.requiredParams ?? capability.required;
  if (legacy !== undefined) {
    if (!Array.isArray(legacy) || legacy.some((key) => typeof key !== 'string' || !key)) {
      errors.push({ code: 'invalid_input_schema', field: 'required', message: 'Invalid legacy parameter declaration.' });
    } else {
      for (const key of legacy as string[]) {
        if (!Object.prototype.hasOwnProperty.call(params, key) || params[key] === '') {
          missing.push(key);
          errors.push({ code: 'missing_parameter', field: key, message: `Parameter '${key}' is required.` });
        }
      }
    }
  }
  if (capability.input_schema !== undefined) {
    try {
      const schema = capability.input_schema;
      if (typeof schema !== 'boolean' && (!schema || typeof schema !== 'object' || Array.isArray(schema))) throw new Error('invalid_schema');
      const dialect = typeof schema === 'object' ? (schema as RecordValue).$schema : undefined;
      const Validator = dialect === 'https://json-schema.org/draft/2020-12/schema' ? Ajv2020
        : dialect === 'https://json-schema.org/draft/2019-09/schema' ? Ajv2019 : Ajv;
      const ajv = new Validator({ strict: true, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false, ownProperties: true });
      addFormats(ajv);
      const validate = ajv.compile(schema as AnySchema);
      if (!validate(params)) {
        for (const error of validate.errors || []) {
          errors.push(schemaError(error));
          if (error.keyword === 'required') missing.push(error.instancePath ? `${error.instancePath}/${String(error.params.missingProperty)}` : String(error.params.missingProperty));
        }
      }
    } catch {
      errors.push({ code: 'invalid_input_schema', field: 'input_schema', message: 'The declared input schema is invalid or unsupported.' });
    }
  }
  return { missing: [...new Set(missing)], errors };
}

export function canonicalIntentJson(value: unknown): string {
  function sorted(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(sorted);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, sorted(entry)]));
    return item;
  }
  return JSON.stringify(sorted(value));
}
