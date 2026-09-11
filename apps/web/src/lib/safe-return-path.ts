/** Only local page destinations. URL parsing alone normalizes backslashes into hosts. */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020]/.test(value))
    return '/';
  try {
    const url = new URL(value, 'https://beautyos.invalid');
    if (url.origin !== 'https://beautyos.invalid' || /^\/(api|session)(\/|$)/.test(url.pathname))
      return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}
