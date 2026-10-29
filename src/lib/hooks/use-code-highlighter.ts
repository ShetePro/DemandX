'use client';

import { useEffect, useState } from 'react';
import type { CodeHighlighterPlugin } from 'streamdown';

/** Only fenced blocks are highlighted; inline `` `code` `` needs no Shiki. */
const FENCED_CODE = /^\s*(```|~~~)/m;

/**
 * Shiki plus every grammar is by far the heaviest part of the markdown bundle,
 * so it is imported the first time a fenced block actually appears in a
 * message. Until then (and if the chunk fails to load) code fences render
 * unstyled rather than delaying the answer.
 */
export function useCodeHighlighter(markdown: string): CodeHighlighterPlugin | undefined {
  const needsHighlighting = FENCED_CODE.test(markdown);
  const [plugin, setPlugin] = useState<CodeHighlighterPlugin>();

  useEffect(() => {
    if (!needsHighlighting || plugin !== undefined) return;

    let active = true;
    void import('@streamdown/code')
      .then((module) => {
        if (active) setPlugin(module.code);
      })
      .catch(() => {
        // Unstyled code blocks are an acceptable degradation.
      });

    return () => {
      active = false;
    };
  }, [needsHighlighting, plugin]);

  return needsHighlighting ? plugin : undefined;
}
