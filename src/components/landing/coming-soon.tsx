type ComingSoonProps = {
  badge: string;
  title: string;
  subtitle: string;
  status: string;
};

export function ComingSoon({ badge, title, subtitle, status }: ComingSoonProps) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-6 px-6 py-24 text-center">
      <span className="rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground">
        {badge}
      </span>
      <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">{title}</h1>
      <p className="text-lg text-pretty text-muted-foreground">{subtitle}</p>
      <p className="text-sm text-muted-foreground">{status}</p>
    </main>
  );
}
