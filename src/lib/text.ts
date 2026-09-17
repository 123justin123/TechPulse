import { decodeHTML } from "entities";

export function plainText(text: string): string {
  return decodeHTML(text).trim();
}
