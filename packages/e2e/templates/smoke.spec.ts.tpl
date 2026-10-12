import { smokeTest } from './kit'

/**
 * Every page listed here is opened and checked in every browser: loads without
 * JS errors, no 5xx, no sideways scrolling, accessibility (WCAG AA). Just add
 * the project's most important routes.
 */
smokeTest({{ROUTES}})
