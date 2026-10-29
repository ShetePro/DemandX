import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Compose class names, letting later Tailwind utilities win conflicting earlier ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
