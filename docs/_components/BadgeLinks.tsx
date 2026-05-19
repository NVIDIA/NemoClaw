/**
 * Badge links for GitHub, License, project status, Discord, etc.
 * Uses a flex wrapper to display badges horizontally and hides Fern's
 * external-link icon that otherwise stacks under each badge image.
 * Requires the `.badge-links` CSS rule from main.css.
 */
export type BadgeItem = {
  href: string;
  src: string;
  alt: string;
};

export function BadgeLinks({ badges = [] }: { badges?: BadgeItem[] }) {
  if (badges.length === 0) {
    return null;
  }
  return (
    <div className="badge-links">
      {badges.map((b) => (
        <a key={b.href} href={b.href} target="_blank" rel="noreferrer">
          <img src={b.src} alt={b.alt} />
        </a>
      ))}
    </div>
  );
}
