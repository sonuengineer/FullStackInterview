# Blog: "AI Built the Website in 2 Hours." Now Check the 20 Things It Probably Forgot.

*A working demo is not a production website. The boring 20% is what makes it real.*

This connects to [[55-blog-engineering-harder-building-easier]]: building got easy, but making something production-ready is still engineering. Here's a checklist, grouped so it's easier to work through. Each item has a one-line "why it matters."

---

## Group 1 - When Things Go Wrong

1. **Proper error handling** - a failed API call should show a helpful message, not a blank screen or a raw stack trace (which can also leak internals).
2. **Empty states** - a new user with zero orders should see "No orders yet - start shopping," not an empty white box.
3. **Loading states** - spinners or skeletons, so users don't click three times thinking nothing happened.
4. **404 and 500 pages** - friendly pages with a way back home, instead of the hosting provider's default error.

## Group 2 - Users and Devices

5. **Mobile navigation** - most traffic is on phones; the menu must work on a small screen (we fixed exactly this on this dashboard).
6. **Form validation** - on the client for UX, and **always on the server** for security ([[66-blog-before-first-backend-job]]).
7. **Accessibility** - labels, alt text, keyboard navigation, and color contrast, so everyone can use it (and to avoid legal risk in some countries).
8. **Image optimization** - compressed, modern formats (WebP/AVIF), correct sizes, lazy loading - often the biggest speed win ([[51-fast-api-slow-page]]).

## Group 3 - Security and Abuse

9. **Rate limiting** - on login, signup, contact forms, and APIs, or bots will find them within days.
10. **Authentication edge cases** - password reset, expired sessions, logout on all devices ([[09-jwt-logout-invalidation]]), email change, brute-force protection.
11. **Security headers** - HTTPS/HSTS, Content-Security-Policy, X-Frame-Options, and proper CORS ([[07-cors-error-fix]]).
12. **Email confirmations** - verify addresses before trusting them, and send receipts for important actions.

## Group 4 - Being Found and Shared

13. **SEO metadata** - a unique title and description per page.
14. **OG previews** - Open Graph tags so a shared link on WhatsApp/LinkedIn shows a title, image, and description instead of a bare URL.
15. **Favicon** - small, but a site without one looks unfinished in every browser tab.
16. **Sitemap** - helps search engines find all your pages.
17. **robots.txt** - tells crawlers what to index (and make sure it isn't accidentally blocking the whole site).

## Group 5 - Running It for Real

18. **Analytics** - you can't improve what you can't see (and respect privacy/consent rules).
19. **Privacy and terms pages** - legally required in many places, especially if you collect any personal data or take payments.
20. **Backup and monitoring** - uptime checks, error tracking, and **tested** restores. A backup you've never restored is only a hope.

---

## Why AI Tends to Skip These

AI optimizes for "the thing you asked for works." These 20 items are mostly about **what happens around the happy path**: failure, abuse, strangers finding the page, and the site still running next month. Nobody writes "remember robots.txt" in their prompt, so it doesn't get built.

## How to Use This

Before calling any AI-built project "done," go through the 20 items and mark each one: done, not needed, or todo. Most take minutes each. Together, they're the difference between a demo and a product.

## 🧠 Remember

> AI builds the 80% you asked for. The boring 20% - errors, edge cases, security, discoverability, and operations - is what makes it a real production website.
