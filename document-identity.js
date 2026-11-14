// Browser-issued document IDs are required, never synthesized from tab/URL data.
export const validDocumentId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(value);

export function injectedDocument(results, expected) {
  const result = results?.[0];
  if (!result || result.error || !validDocumentId(result.documentId) || (expected && result.documentId !== expected) || !result.result || result.result.error) {
    throw new Error(result?.result?.error || 'The document could not be read securely. Select it again and check website access.');
  }
  return result;
}
