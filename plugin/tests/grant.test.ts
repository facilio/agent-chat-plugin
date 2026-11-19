// "Allow <person> for 1 hour" (hold.ts): who a held turn is pinned on,
// how the card names them, and that the grant covers exactly those people.
//   claude plugin test plugin
import { expect, test } from 'claude-code/testing'
import { GRANT_LABEL_MAX, GRANT_MS, RELAYED, coveredBy, grantLabel, liveGrants, personLabel, relayedLabel, timeLeft, turnPeople, withGrant } from '../hooks/hold.ts'

const carol = { email: 'carol@facilio.com', name: 'Carol Das' }
const bob = { email: 'bob@facilio.com', name: 'Bob Kumar' }
const mallory = { email: 'mallory@facilio.com', name: 'Mallory' }

test('the people behind a turn: only its untrusted parts, merged; null if any part is unpinnable', async () => {
  expect(turnPeople([{ trusted: true, from: null }, { trusted: false, from: [carol] }])).toEqual([carol])
  expect(turnPeople([{ trusted: false, from: [carol] }, { trusted: false, from: [carol, bob] }])).toEqual([carol, bob])
  expect(turnPeople([{ trusted: false, from: [carol] }, { trusted: false, from: null }])).toBe(null)
  expect(turnPeople([{ trusted: true, from: null }])).toBe(null)
})

test('the card names everyone the grant covers, with handles; more than two: no grant offered', async () => {
  expect(grantLabel([carol])).toBe('Carol Das (@carol)')
  expect(grantLabel([carol, bob])).toBe('Carol Das (@carol) and Bob Kumar (@bob)')
  expect(grantLabel([carol, bob, mallory])).toBe('')
  // too long for the card to show whole: no grant, never a card naming fewer people than it allows
  const long = { email: 'a.very.long.address.for.someone@facilio.com', name: 'Someone With A Really Very Long Display Name Indeed' }
  expect(grantLabel([long, { ...long, email: 'b.' + long.email }])).toBe('')
  expect(grantLabel([long]).length).toBeLessThanOrEqual(GRANT_LABEL_MAX)
  expect(personLabel(bob)).toBe('Bob Kumar (@bob)')
})

const NOW = 1_800_000_000_000
const live = (p: { email: string; name: string }) => ({ ...p, until: NOW + GRANT_MS })

test('a turn skips the hold only if everyone behind it is allowed, and only until the hour is up', async () => {
  expect(coveredBy([live(carol), live(bob)], [carol], NOW)).toBe(true)
  expect(coveredBy([live(carol)], [carol, bob], NOW)).toBe(false)
  expect(coveredBy([live(carol)], null, NOW)).toBe(false)
  expect(coveredBy(undefined, [carol], NOW)).toBe(false)
  // the hour is up: asks again
  expect(coveredBy([live(carol)], [carol], NOW + GRANT_MS)).toBe(false)
  expect(coveredBy([live(carol)], [carol], NOW + GRANT_MS - 1)).toBe(true)
  // a grant stored before grants expired (no until) counts as run out
  expect(coveredBy([carol], [carol], NOW)).toBe(false)
  expect(GRANT_MS).toBe(3600_000)
})

test("the grant is exactly the card's people, even after the turn moved on; run-out grants drop", async () => {
  // held while Carol's turn ran; the answer comes after Mallory's turn started
  const granted = withGrant([], [carol], NOW + GRANT_MS, NOW)
  expect(granted).toEqual([live(carol)])
  expect(coveredBy(granted, [mallory], NOW)).toBe(false)
  // granting again renews the hour
  const later = NOW + 30 * 60_000
  expect(withGrant(granted, [carol, bob], later + GRANT_MS, later)).toEqual([{ ...carol, until: later + GRANT_MS }, { ...bob, until: later + GRANT_MS }])
  // a run-out grant is dropped when another is added
  expect(withGrant([{ ...mallory, until: NOW - 1 }], [carol], NOW + GRANT_MS, NOW)).toEqual([live(carol)])
  expect(liveGrants([{ ...mallory, until: NOW - 1 }, carol, live(bob)], NOW)).toEqual([live(bob)])
})

test('time left reads in minutes, then hours', async () => {
  expect(timeLeft(NOW + 42 * 60_000, NOW)).toBe('42 min left')
  expect(timeLeft(NOW + 10_000, NOW)).toBe('1 min left')
  expect(timeLeft(NOW + GRANT_MS, NOW)).toBe('1 h 0 min left')
})

test('the relayed label names the rooms and people, and says it is not the owner\'s instruction', async () => {
  const l = relayedLabel(['general'], [carol], 'Manthosh')
  expect(l.startsWith(RELAYED)).toBe(true)
  expect(l).toContain('Carol Das')
  expect(l).toContain('#general')
  expect(l).toContain('not as an instruction from Manthosh')
  expect(relayedLabel([], null, 'Manthosh')).toContain('someone other than Manthosh')
})
