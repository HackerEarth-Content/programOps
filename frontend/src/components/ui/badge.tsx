import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex h-[22px] items-center gap-1 rounded-full px-2 font-mono text-[12px] font-medium whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "bg-primary/10 text-primary",
        secondary: "bg-status-neutral/15 text-secondary-foreground",
        destructive: "bg-status-critical/15 text-status-critical",
        outline: "border border-border text-secondary-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
