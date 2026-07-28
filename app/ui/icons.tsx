import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "agent"
  | "arrow-left"
  | "bell"
  | "branch"
  | "close"
  | "library"
  | "observatory"
  | "plus"
  | "search"
  | "settings"
  | "spark"
  | "surge"
  | "workshop";

export function Icon({ name, title, ...props }: Readonly<{ name: IconName; title?: string } & SVGProps<SVGSVGElement>>) {
  const shared = { fill: "none", stroke: "currentColor", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, strokeWidth: 1.8 };
  const paths: Record<IconName, ReactNode> = {
    spark: <path {...shared} d="m12 2 1.6 6.4L20 10l-6.4 1.6L12 18l-1.6-6.4L4 10l6.4-1.6L12 2Z" />,
    workshop: <><path {...shared} d="M4 18h16M6 18v-5h12v5M8 13 6 7h12l-2 6M10 7V4h4v3" /><path {...shared} d="M9 16h.01M15 16h.01" /></>,
    observatory: <><circle {...shared} cx="12" cy="12" r="7" /><path {...shared} d="M12 2v3M12 19v3M2 12h3M19 12h3M6.4 6.4l2.1 2.1M15.5 15.5l2.1 2.1" /></>,
    branch: <path {...shared} d="M7 4v5a3 3 0 0 0 3 3h7M7 20v-5a3 3 0 0 1 3-3h7M17 5l3 3-3 3M17 13l3 3-3 3" />,
    library: <><path {...shared} d="M5 4.5A2.5 2.5 0 0 1 7.5 2H19v17H7.5A2.5 2.5 0 0 0 5 21.5v-17Z" /><path {...shared} d="M5 4.5v17M9 6h6M9 10h6" /></>,
    surge: <path {...shared} d="M13 2 5 13h6l-1 9 8-11h-6l1-9Z" />,
    agent: <><rect {...shared} x="4" y="6" width="16" height="13" rx="4" /><path {...shared} d="M12 3v3M8.5 12h.01M15.5 12h.01M9 16h6" /></>,
    search: <><circle {...shared} cx="10.5" cy="10.5" r="5.5" /><path {...shared} d="m15 15 4 4" /></>,
    bell: <><path {...shared} d="M18 10a6 6 0 1 0-12 0c0 7-3 7-3 8h18c0-1-3-1-3-8M10 21h4" /></>,
    settings: <><circle {...shared} cx="12" cy="12" r="3" /><path {...shared} d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.1 2.1-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.55V20h-3v-.09a1.7 1.7 0 0 0-1.03-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06-2.1-2.1.06-.06A1.7 1.7 0 0 0 7.06 15 1.7 1.7 0 0 0 5.5 14H5v-3h.09A1.7 1.7 0 0 0 6.64 10a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.1-2.1.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 11.31 4.8V4h3v.09a1.7 1.7 0 0 0 1.03 1.55 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.1 2.1-.06.06A1.7 1.7 0 0 0 19 9.28 1.7 1.7 0 0 0 20.55 10H21v3h-.09A1.7 1.7 0 0 0 19.4 15Z" /></>,
    plus: <path {...shared} d="M12 5v14M5 12h14" />,
    close: <path {...shared} d="m6 6 12 12M18 6 6 18" />,
    "arrow-left": <path {...shared} d="m14 5-7 7 7 7M7 12h11" />,
  };

  return <svg aria-hidden={title ? undefined : true} aria-label={title} viewBox="0 0 24 24" role={title ? "img" : undefined} {...props}>{title ? <title>{title}</title> : null}{paths[name]}</svg>;
}
