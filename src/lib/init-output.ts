/**
 * Terminal plumbing for `synap init`: collapse a step's output to one line
 * unless it fails, and keep stdout clean for `--json`.
 */

type Write = typeof process.stdout.write;

/**
 * Run `fn` with everything it writes to stdout/stderr held back. Returns the
 * held output so the caller can replay it only when the step failed.
 */
export async function withHeldOutput<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; held: string }> {
  const chunks: string[] = [];
  const outWrite = process.stdout.write;
  const errWrite = process.stderr.write;
  const hold = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    const cb = rest.find((r) => typeof r === "function") as (() => void) | undefined;
    cb?.();
    return true;
  }) as Write;
  process.stdout.write = hold;
  process.stderr.write = hold;
  try {
    return { value: await fn(), held: chunks.join("") };
  } catch (error) {
    return { error, held: chunks.join("") };
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
  }
}

/**
 * For `--json`: send every human line to stderr for the rest of the run and
 * return the one writer that still reaches stdout, for the JSON summary.
 */
export function reserveStdoutForJson(): (text: string) => void {
  const outWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as Write;
  return (text) => {
    outWrite(text);
  };
}
