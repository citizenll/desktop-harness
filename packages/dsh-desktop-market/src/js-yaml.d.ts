declare module 'js-yaml' {
  export class Type {
    constructor(tag: string, options?: Record<string, unknown>)
  }

  export interface Schema {
    extend(type: Type | readonly Type[]): Schema
  }

  export const JSON_SCHEMA: Schema
  export function load(source: string, options?: { schema?: Schema }): unknown
}
