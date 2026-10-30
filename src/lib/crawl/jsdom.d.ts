/**
 * jsdom ships JavaScript only, and `@types/jsdom` would be a dependency we do
 * not otherwise need. This declares just the surface the extractor touches;
 * callers cast the DOM to the standard `Document` from `lib.dom`.
 */
declare module 'jsdom' {
  export interface JSDOMOptions {
    url?: string;
    contentType?: string;
  }

  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions);
    readonly window: {
      document: unknown;
      close(): void;
    };
  }
}
