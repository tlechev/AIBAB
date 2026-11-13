import { getTranslations } from "next-intl/server";

import { ComingSoon } from "@/components/landing/coming-soon";

export default async function HomePage() {
  const t = await getTranslations("Home");
  return (
    <ComingSoon
      badge={t("badge")}
      title={t("title")}
      subtitle={t("subtitle")}
      status={t("status")}
    />
  );
}
