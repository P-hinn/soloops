import { smokeTest } from './kit'

/**
 * Jede Seite hier wird in jedem Browser geöffnet und geprüft: lädt ohne
 * JS-Fehler, keine 5xx, kein seitliches Scrollen, Barrierefreiheit (WCAG AA).
 * Einfach um die wichtigsten Routen des Projekts ergänzen.
 */
smokeTest({{ROUTES}})
