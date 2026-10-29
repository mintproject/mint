/**
 * The chrome footer: a User Guide link on the left and "Powered by DYNAMO" on the right of the dark bar, 50px
 * tall. Pinned to the bottom of the viewport by {@link AppShell}, as a sibling
 * of the content row, so the scroll container is unchanged.
 *
 * Unbranded, unlike {@link BrandingStrip} — this is DYNAMO's own credit, and it
 * shows for every deployment.
 */
export function Footer() {
  return (
    <footer className="mint-chrome flex h-[50px] shrink-0 items-center justify-between bg-[color:var(--mint-chrome-bg)] px-6 font-[family-name:var(--mint-chrome-font)] text-[13px] text-[color:var(--mint-chrome-muted)]">
      <a href="/docs/" target="_blank" rel="noreferrer" className="hover:underline">
        User Guide
      </a>
      <span>
        Powered by
        <a
          href="http://mint-project.info/index.html"
          target="_blank"
          rel="noreferrer"
          className="ml-[.2rem] hover:underline"
        >
          DYNAMO
        </a>
      </span>
    </footer>
  );
}
