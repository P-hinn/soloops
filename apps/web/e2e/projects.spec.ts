import { expect, test } from './fixtures'

/**
 * Editing a project, and writing a note where it is read.
 *
 * Both were dead ends: a project was created once and then frozen, and a note
 * on it had to be written on the notes page and assigned by hand. What is
 * checked here is the request that goes out, because the fields the form does
 * not show are the ones that quietly got lost.
 */

test('ein Projekt lässt sich aus der Liste heraus umbenennen', async ({ page }) => {
  await page.goto('/projects')
  await page
    .getByRole('row', { name: /Website Relaunch/ })
    .getByTitle('Bearbeiten')
    .click()

  const name = page.getByLabel('Name', { exact: true })
  await expect(name).toHaveValue('Website Relaunch')
  await name.fill('Website Relaunch II')

  const [request] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith('/api/projects/p1')),
    page.getByRole('button', { name: 'Speichern' }).click(),
  ])

  // Stundensatz, Budget und Beschreibung stehen nicht in der Zeile, sondern am
  // Projekt selbst — sie müssen unverändert zurückgehen statt auf null.
  expect(request.postDataJSON()).toMatchObject({
    key: 'WEB',
    name: 'Website Relaunch II',
    hourlyRateCents: 9500,
    budgetCents: 1_800_000,
    description: 'Neue Startseite, neues CMS.',
  })
})

test('eine geleerte Deadline geht als null raus', async ({ page }) => {
  await page.goto('/projects/p1')
  await page.getByRole('button', { name: 'Bearbeiten' }).click()
  await page.getByLabel('Deadline').fill('')
  await page.getByLabel('Status').selectOption('PAUSED')

  const [request] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith('/api/projects/p1')),
    page.getByRole('button', { name: 'Speichern' }).click(),
  ])

  expect(request.postDataJSON()).toMatchObject({ dueOn: null, status: 'PAUSED' })
})

test('eine Notiz entsteht in der Projektansicht', async ({ page }) => {
  await page.goto('/projects/p1')
  await expect(page.getByText('Anforderungen')).toBeVisible()

  await page.getByRole('button', { name: '+ Notiz' }).click()
  await page.getByPlaceholder('Titel').fill('Kickoff-Protokoll')
  await page.getByPlaceholder('Markdown …').fill('- CMS steht')

  const [request] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/api/notes')),
    page.getByRole('button', { name: 'Speichern' }).click(),
  ])

  expect(request.postDataJSON()).toMatchObject({ title: 'Kickoff-Protokoll', projectId: 'p1' })
})

test('eine bestehende Notiz lässt sich im Projekt bearbeiten', async ({ page }) => {
  await page.goto('/projects/p1')
  await page.getByTitle('Notiz bearbeiten').click()

  const title = page.getByPlaceholder('Titel')
  await expect(title).toHaveValue('Anforderungen')
  await title.fill('Anforderungen v2')

  const [request] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith('/api/notes/n1')),
    page.getByRole('button', { name: 'Speichern' }).click(),
  ])

  expect(request.postDataJSON()).toMatchObject({ title: 'Anforderungen v2', projectId: 'p1' })
})
