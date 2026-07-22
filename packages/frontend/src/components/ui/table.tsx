import * as React from 'react';
import { cn } from '../../lib/format';

export function Table({ className, ...rest }: React.HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-auto scrollbar-thin">
      <table className={cn('w-full caption-bottom text-sm', className)} {...rest} />
    </div>
  );
}

export const THead = (props: React.HTMLAttributes<HTMLTableSectionElement>) => (
  <thead className="[&_tr]:border-b border-border" {...props} />
);

export const TBody = (props: React.HTMLAttributes<HTMLTableSectionElement>) => (
  <tbody className="[&_tr:last-child]:border-0" {...props} />
);

export const TR = ({ className, ...rest }: React.HTMLAttributes<HTMLTableRowElement>) => (
  <tr
    className={cn(
      'border-b border-border transition-colors hover:bg-muted/50',
      className,
    )}
    {...rest}
  />
);

export const TH = ({ className, ...rest }: React.ThHTMLAttributes<HTMLTableCellElement>) => (
  <th className={cn('h-10 px-3 text-left align-middle text-xs font-medium text-muted-foreground', className)} {...rest} />
);

export const TD = ({ className, ...rest }: React.TdHTMLAttributes<HTMLTableCellElement>) => (
  <td className={cn('p-3 align-middle', className)} {...rest} />
);