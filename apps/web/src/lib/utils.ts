/**
 * Shared `cn` helper.
 *
 * The implementation now lives in the `cn` package, which the shadcn/ui
 * registry imports directly. This file re-exports it so project code keeps a
 * single stable import path (`@/lib/utils`) and there is no duplicate
 * implementation.
 */
export { cn } from 'cn';
