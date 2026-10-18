import React from "react";

/**
 * Observatory icon set: engraved line drawings on a 24 unit grid (the brand mark uses 32).
 * One hand for every icon: 1.25 primary strokes, 0.75 hairline details, round caps and joins,
 * small solid bodies (suns, planets, finials) for weight. Colour comes from currentColor.
 */

export type ViewIconName =
  | "orrery"
  | "almanac"
  | "folio"
  | "field-guide"
  | "switchboard"
  | "launchpad"
  | "search";

export interface IconProps extends Omit<React.SVGProps<SVGSVGElement>, "ref"> {
  size?: number;
  /** Accessible name; when omitted the icon is decorative (aria-hidden). */
  title?: string;
  className?: string;
}

const Svg: React.FC<IconProps & { viewBox?: string; name: string }> = ({
  size = 20,
  title,
  className = "",
  viewBox = "0 0 24 24",
  name,
  children,
  ...props
}) => (
  <svg
    width={size}
    height={size}
    viewBox={viewBox}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.25}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={`obs-icon obs-icon--${name} ${className}`.trim()}
    role={title ? "img" : undefined}
    aria-hidden={title ? undefined : true}
    aria-label={title}
    focusable="false"
    {...props}
  >
    {children}
  </svg>
);

/** The Orrery: a sun with its halo ring, one tilted orbit and a planet riding it. */
export const OrreryIcon: React.FC<IconProps> = (p) => (
  <Svg name="orrery" {...p}>
    <circle cx="12" cy="12" r="8.75" strokeWidth={1} />
    <circle cx="12" cy="12" r="5" strokeWidth={0.75} strokeDasharray="0.1 1.7" />
    <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
    <path d="M12 7.6v-1M12 17.4v-1M7.6 12h-1M17.4 12h-1" strokeWidth={0.6} />
    <circle cx="18.7" cy="6.38" r="1.95" fill="currentColor" stroke="none" />
    <circle cx="7.67" cy="14.5" r="1.1" fill="currentColor" stroke="none" />
  </Svg>
);

/** The Almanac: a bound page with a crescent moon and ruled entries. */
export const AlmanacIcon: React.FC<IconProps> = (p) => (
  <Svg name="almanac" {...p}>
    <rect x="5" y="3.5" width="14" height="17" rx="1.5" />
    <path d="M8 3.5v17" strokeWidth={0.75} />
    <path d="M14.25 6.25A2.75 2.75 0 0 0 14.25 11.75A3.4 3.4 0 0 1 14.25 6.25Z" fill="currentColor" stroke="none" />
    <path d="M10.75 14.5h5.5M10.75 17h3.75" strokeWidth={0.75} />
    <circle cx="16.6" cy="7.4" r="0.55" fill="currentColor" stroke="none" />
  </Svg>
);

/** The Folio: a parchment leaf hanging from its roll, one corner turned. */
export const FolioIcon: React.FC<IconProps> = (p) => (
  <Svg name="folio" {...p}>
    <path d="M5.75 4h12.5a1.5 1.5 0 0 1 0 3H5.75a1.5 1.5 0 0 1 0-3Z" />
    <path d="M7 7v13h8l2-2V7" />
    <path d="M15 20v-2h2" strokeWidth={0.75} />
    <path d="M9.5 10.5h5M9.5 13h5M9.5 15.5h3" strokeWidth={0.75} />
  </Svg>
);

/** The Field Guide: a bound guide with a star emblem on its cover and a ribbon marker. */
export const FieldGuideIcon: React.FC<IconProps> = (p) => (
  <Svg name="field-guide" {...p}>
    <path d="M6.5 3.5h11a1 1 0 0 1 1 1v13.25H8a1.5 1.5 0 0 0-1.5 1.5Z" />
    <path d="M6.5 19.25A1.5 1.5 0 0 0 8 20.75h10.5v-3" />
    <path d="M9 3.5v14.25" strokeWidth={0.75} />
    <path d="M13.75 6.75l.7 2.55 2.55.7-2.55.7-.7 2.55-.7-2.55-2.55-.7 2.55-.7Z" fill="currentColor" strokeWidth={0.5} />
    <path d="M15.75 17.75v4l-1-.85-1 .85v-4" strokeWidth={0.75} />
  </Svg>
);

/** The Switchboard: two banks of jacks with patch cords between them. */
export const SwitchboardIcon: React.FC<IconProps> = (p) => (
  <Svg name="switchboard" {...p}>
    <path d="M6.9 6C11.5 6 12.5 12 17.1 12" />
    <path d="M6.9 18C11.5 18 12.5 6 17.1 6" />
    <circle cx="5.5" cy="6" r="1.4" strokeWidth={1.1} />
    <circle cx="5.5" cy="12" r="1.4" strokeWidth={1.1} />
    <circle cx="5.5" cy="18" r="1.4" strokeWidth={1.1} />
    <circle cx="18.5" cy="6" r="1.4" strokeWidth={1.1} />
    <circle cx="18.5" cy="12" r="1.4" strokeWidth={1.1} />
    <circle cx="18.5" cy="18" r="1.4" strokeWidth={1.1} />
    <path d="M3 3.5v17M21 3.5v17" strokeWidth={0.75} />
  </Svg>
);

/** The Launchpad: an observatory dome sending a comet up into the sky. */
export const LaunchpadIcon: React.FC<IconProps> = (p) => (
  <Svg name="launchpad" {...p}>
    <path d="M3.5 20h17" strokeWidth={0.75} />
    <path d="M4.25 20a4.75 4.75 0 0 1 9.5 0" />
    <path d="M9 15.25V20" strokeWidth={0.75} />
    <path d="M10.75 13.75l4.9-4.9" />
    <path d="M12.6 15.1l3.7-3.7M9.4 11.9l3.7-3.7" strokeWidth={0.75} />
    <circle cx="17.25" cy="7.25" r="1.9" fill="currentColor" stroke="none" />
    <path d="M17.25 2.75v1.2M21.75 7.25h-1.2M20.4 4.1l-.85.85" strokeWidth={0.75} />
  </Svg>
);

/** Search: a lens with a reticle and a turned handle. */
export const SearchIcon: React.FC<IconProps> = (p) => (
  <Svg name="search" {...p}>
    <circle cx="10.25" cy="10.25" r="6.25" />
    <path d="M10.25 5.5v1.6M10.25 13.4V15M5.5 10.25h1.6M13.4 10.25H15" strokeWidth={0.75} />
    <circle cx="10.25" cy="10.25" r="0.8" fill="currentColor" stroke="none" />
    <path d="M14.85 14.85L20 20" strokeWidth={2} />
    <path d="M14.2 16.3l2.1-2.1" strokeWidth={0.75} />
  </Svg>
);

export const VIEW_ICONS: Record<ViewIconName, React.FC<IconProps>> = {
  orrery: OrreryIcon,
  almanac: AlmanacIcon,
  folio: FolioIcon,
  "field-guide": FieldGuideIcon,
  switchboard: SwitchboardIcon,
  launchpad: LaunchpadIcon,
  search: SearchIcon,
};

export const ViewIcon: React.FC<IconProps & { name: ViewIconName }> = ({ name, ...p }) => {
  const Icon = VIEW_ICONS[name];
  return <Icon {...p} />;
};

/**
 * The brand mark: an armillary sphere. Meridian ring drawn as a band, the equator, the ecliptic band
 * tilted 23.4 degrees, a colure, the earth at the centre, the polar axis with finials, and a stand.
 */
export const ArmillaryMark: React.FC<IconProps> = ({ size = 32, ...p }) => (
  <Svg name="armillary" viewBox="0 0 32 32" size={size} {...p}>
    <circle cx="16" cy="14.5" r="10.5" strokeWidth={1.1} />
    <circle cx="16" cy="14.5" r="9.7" strokeWidth={0.4} />
    <ellipse cx="16" cy="14.5" rx="3.4" ry="10.5" strokeWidth={0.55} />
    <ellipse cx="16" cy="14.5" rx="10.5" ry="3.1" strokeWidth={0.7} />
    <g transform="rotate(-23.4 16 14.5)">
      <ellipse cx="16" cy="14.5" rx="10.5" ry="3.3" strokeWidth={0.95} />
      <ellipse cx="16" cy="14.5" rx="10.5" ry="4.4" strokeWidth={0.45} />
    </g>
    <path d="M16 2v25" strokeWidth={0.75} />
    <circle cx="16" cy="2.1" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="16" cy="14.5" r="1.9" fill="currentColor" stroke="none" />
    <path d="M16 25v3.25" strokeWidth={1} />
    <path d="M11.75 30h8.5" strokeWidth={1.1} />
    <path d="M13.6 28.65h4.8" strokeWidth={0.6} />
  </Svg>
);

/** Day almanac (light theme): an engraved sun with alternating long and short rays. */
export const DayIcon: React.FC<IconProps> = (p) => (
  <Svg name="day" {...p}>
    <circle cx="12" cy="12" r="3.75" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
    <path d="M5.9 5.9l1.6 1.6M16.5 16.5l1.6 1.6M5.9 18.1l1.6-1.6M16.5 7.5l1.6-1.6" strokeWidth={0.75} />
  </Svg>
);

/** Night (dark theme): a crescent moon with one star. */
export const NightIcon: React.FC<IconProps> = (p) => (
  <Svg name="night" {...p}>
    <path d="M14.5 4.25a7.75 7.75 0 1 0 5.25 13.5A6.25 6.25 0 0 1 14.5 4.25Z" />
    <path d="M18.25 4.5l.45 1.3 1.3.45-1.3.45-.45 1.3-.45-1.3-1.3-.45 1.3-.45Z" fill="currentColor" strokeWidth={0.5} />
  </Svg>
);

/** Replay the first run: a returning arc around a small star. */
export const ReplayIcon: React.FC<IconProps> = (p) => (
  <Svg name="replay" {...p}>
    <path d="M5.25 12a6.75 6.75 0 1 0 2-4.8" />
    <path d="M5 4.5v3.25h3.25" />
    <path d="M12 9.5l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6Z" fill="currentColor" strokeWidth={0.5} />
  </Svg>
);

export const ChevronDownIcon: React.FC<IconProps> = (p) => (
  <Svg name="chevron-down" {...p}>
    <path d="M7 10l5 5 5-5" />
  </Svg>
);

export const CheckIcon: React.FC<IconProps> = (p) => (
  <Svg name="check" {...p}>
    <path d="M5.5 12.5l4 4 9-9" strokeWidth={1.5} />
  </Svg>
);

export const CloseIcon: React.FC<IconProps> = (p) => (
  <Svg name="close" {...p}>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </Svg>
);
