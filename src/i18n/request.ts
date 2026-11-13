import { getRequestConfig } from "next-intl/server";

import { defaultLocale, defaultTimeZone } from "./config";

/**
 * ADR-001: no locale in the URL. Until authentication exists (task 3) the
 * active locale is always the default (bg). Later it will come from the
 * user's / organization's preference.
 */
export default getRequestConfig(async () => {
  const locale = defaultLocale;
  return {
    locale,
    timeZone: defaultTimeZone,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
