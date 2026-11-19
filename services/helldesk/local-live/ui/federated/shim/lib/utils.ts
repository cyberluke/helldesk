import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Tailwind class combiner (original `@/lib/utils` cn). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}