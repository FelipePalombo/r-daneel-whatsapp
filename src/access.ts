import { readFile } from 'node:fs/promises';

export function parseAllowedNumbers(text: string): string[] {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || !('numbers' in value) ||
      !Array.isArray(value.numbers) || value.numbers.length === 0 ||
      !value.numbers.every((phone: unknown) => typeof phone === 'string' && /^[1-9]\d{7,14}$/.test(phone))) {
    throw new Error('allowed-numbers.json deve conter numbers com pelo menos um telefone em texto, país + DDD + número, somente dígitos.');
  }
  return [...new Set(value.numbers as string[])];
}

export async function loadAllowedNumbers(path = './allowed-numbers.json'): Promise<string[]> {
  return parseAllowedNumbers(await readFile(path, 'utf8'));
}
