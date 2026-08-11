export function parseCubeCobraInput(input: string): string | null {
  if (input.startsWith("cubecobra:")) {
    return input.slice("cubecobra:".length);
  }
  const urlMatch = input.match(/cubecobra\.com\/cube\/(?:list|overview|analysis)\/([^/?#]+)/);
  if (urlMatch) return urlMatch[1];
  return null;
}

export async function fetchCubeCobraList(cubeId: string): Promise<string[]> {
  const url = `https://cubecobra.com/cube/api/cubelist/${encodeURIComponent(cubeId)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `CubeCobra API returned ${response.status} for cube "${cubeId}". ` +
        `Try the file: fallback instead (--pool file:path/to/list.txt).`
    );
  }
  const text = await response.text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function loadCardPool(poolArg: string): Promise<string[]> {
  const cubeId = parseCubeCobraInput(poolArg);
  if (cubeId) {
    return fetchCubeCobraList(cubeId);
  }
  if (poolArg.startsWith("file:")) {
    const fs = await import("fs/promises");
    const filePath = poolArg.slice("file:".length);
    const text = await fs.readFile(filePath, "utf-8");
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
  throw new Error(
    `Unrecognized pool format: "${poolArg}". ` +
      `Use cubecobra:<id>, a CubeCobra URL, or file:<path>.`
  );
}
