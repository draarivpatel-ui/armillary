import React from "react";

export interface ListProps extends React.HTMLAttributes<HTMLUListElement> {
  children: React.ReactNode;
  "aria-label"?: string;
}

export const List: React.FC<ListProps> = ({
  children,
  className = "",
  "aria-label": ariaLabel,
  ...props
}) => {
  return (
    <ul
      role="list"
      aria-label={ariaLabel}
      className={`obs-list ${className}`.trim()}
      {...props}
    >
      {children}
    </ul>
  );
};

export interface ListItemProps extends React.LiHTMLAttributes<HTMLLIElement> {
  selected?: boolean;
  children: React.ReactNode;
}

export const ListItem: React.FC<ListItemProps> = ({
  selected = false,
  children,
  className = "",
  onClick,
  ...props
}) => {
  return (
    <li
      role="listitem"
      aria-selected={selected}
      tabIndex={onClick ? 0 : undefined}
      className={`obs-list-item ${className}`.trim()}
      onClick={onClick}
      onKeyDown={(e) => {
        if (onClick && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick(e as unknown as React.MouseEvent<HTMLLIElement>);
        }
      }}
      {...props}
    >
      {children}
    </li>
  );
};
