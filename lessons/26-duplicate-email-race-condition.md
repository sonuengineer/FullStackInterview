# Two Users Register With the Same Email at the Same Instant

> **Same-question flag**: this is the exact race condition already covered in [[05-username-availability-check]]'s "common mistake" section - a check-then-act gap, just triggered by email instead of username. No new mechanism to teach here; what's worth adding is the formal name for this class of bug, since it shows up constantly under different disguises.

## 1. Story

Two users hit "register" with the same email within the same instant. Both requests check "is this email taken?" - both get "no." Both accounts get created. Now there are two accounts sharing one email, login is ambiguous, password reset is ambiguous, authentication is quietly broken forever - and nothing ever logged an error.

## 2. What's Actually Missing

**Term: TOCTOU (Time-Of-Check to Time-Of-Use)** - a race condition where the gap between checking a condition and acting on it is wide enough for another process to invalidate that check before the action happens. Here: check "email free" -> *(gap)* -> insert row. If a second request runs its own check in that gap, both see "free" and both proceed.

The fix is identical in shape to [[05-username-availability-check]]: the application-level check is only ever a UX hint. The actual guarantee has to come from an **atomic, database-enforced unique constraint** on the email column, checked by the database itself at the moment of insert - not by two separate application steps that can interleave.

```sql
ALTER TABLE users ADD CONSTRAINT unique_email UNIQUE (email);
-- The second concurrent INSERT throws a constraint violation instead of
-- silently succeeding - the application catches it and returns "email taken."
```

## 3. 🧠 Remember

> Any "check, then act" sequence with a gap in between is a race condition waiting to happen under concurrency - the fix is never a faster check, it's making the actual write atomic and constraint-enforced at the database level.

## 4. Quick Self-Test

1. Why does checking "is this email taken" faster not actually fix the race condition?
2. What database feature turns this from a possible bug into an impossible one?
3. Name one other place in this curriculum where the exact same check-then-act gap showed up.
