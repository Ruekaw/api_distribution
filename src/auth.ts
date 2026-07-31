const encoder = new TextEncoder();

async function digest(value: string): Promise<Uint8Array> {
  const result = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return new Uint8Array(result);
}

export async function verifyBearer(
  authorization: string | null,
  expected: string,
): Promise<boolean> {
  const validFormat = authorization?.startsWith("Bearer ") === true;
  const supplied = validFormat ? authorization!.slice("Bearer ".length) : "";
  const [suppliedDigest, expectedDigest] = await Promise.all([
    digest(supplied),
    digest(expected),
  ]);

  let difference = 0;
  for (let index = 0; index < expectedDigest.length; index += 1) {
    difference |= suppliedDigest[index]! ^ expectedDigest[index]!;
  }
  return validFormat && difference === 0;
}
