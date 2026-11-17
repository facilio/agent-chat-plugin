// "Allow <person> for this session" (hold.ts): who a held turn is pinned on,
// how the card names them, and that the grant covers exactly those people.
//   claude plugin test plugin
import { expect, test } from 'claude-code/testing'
import { coveredBy, grantLabel, turnPeople, withGrant } from '../hooks/hold.ts'

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
})

test('a turn skips the hold only if everyone behind it is allowed', async () => {
  expect(coveredBy([carol, bob], [carol])).toBe(true)
  expect(coveredBy([carol], [carol, bob])).toBe(false)
  expect(coveredBy([carol], null)).toBe(false)
  expect(coveredBy(undefined, [carol])).toBe(false)
})

test("the grant is exactly the card's people, even after the turn moved on", async () => {
  // held while Carol's turn ran; the answer comes after Mallory's turn started
  const onTheCard = [carol]
  const turnFromWhenAnswered = [mallory]
  const granted = withGrant([], onTheCard)
  expect(granted).toEqual([carol])
  expect(coveredBy(granted, turnFromWhenAnswered)).toBe(false)
  expect(withGrant([carol], [carol, bob])).toEqual([carol, bob])
})
