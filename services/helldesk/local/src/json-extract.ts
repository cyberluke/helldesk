/**
 * Extract the first balanced JSON object from model text.
 * Shared by review verdicts and small structured probes (task sizing).
 */
export function extractJsonObject(text: string): unknown {
  // Strip surrounding prose: find the first '{' ... matching '}'.
  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in model output');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        return JSON.parse(slice);
      }
    }
  }
  throw new Error('Unbalanced JSON object in model output');
}
