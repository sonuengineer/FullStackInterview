# Tech Lead Says "Never Use an ORM." What's Your Reply?

## 1. Story

Your tech lead has been burned before: a page that made 400 database queries, a report that took 30 seconds because the ORM generated an insane join, a migration nobody understood. So now the rule is: "Never use an ORM for database queries."

## 2. What an ORM Actually Is

**Term: ORM (Object-Relational Mapper)** - a library (Prisma, Sequelize, TypeORM, Hibernate, Django ORM, SQLAlchemy) that maps database rows to objects in your code, so you write `User.findById(1)` instead of `SELECT * FROM users WHERE id = 1`.

It's a productivity and safety tool, not a performance tool.

## 3. Why the Tech Lead Isn't Wrong

The pain is real:

- **The N+1 problem.** Load 100 orders, then access `order.customer` in a loop: the ORM quietly runs 1 query for orders + 100 queries for customers = 101 round trips, where one join would have done it.
- **Hidden, inefficient SQL.** Complex filters and joins can generate SQL no human would write, and nobody looks at it until it's slow.
- **Over-fetching.** `SELECT *` by default, loading columns you don't need.
- **Leaky abstraction.** Developers stop learning SQL and can't debug the query plan (see [[50-slow-query-500m-rows]]).

## 4. Why "Never" Is Too Strong

- Most application queries are simple CRUD. Hand-writing hundreds of them is slow, repetitive, and error-prone.
- ORMs give you **parameterized queries by default**, which protects against SQL injection - hand-built SQL strings are a common source of exactly that bug.
- Migrations, relations, and type safety come for free.
- Nearly every ORM has an escape hatch to raw SQL when you need it.

## 5. A Good Reply

> "I agree the ORM has burned us. But I'd rather set rules than ban it: use the ORM for simple CRUD, where it's safe and fast to write. For complex reports, hot paths, and bulk operations, write raw SQL or use a query builder. Log the SQL the ORM generates, watch for N+1 in code review, and check `EXPLAIN` on anything slow. The problem isn't the ORM, it's not knowing what SQL it runs."

## 6. Code Example

```javascript
// N+1: 1 query for orders + 1 query per order for the customer
const orders = await Order.findAll();
for (const o of orders) {
  console.log((await o.getCustomer()).name);
}

// Fixed with the ORM: eager-load, one query with a join
const orders2 = await Order.findAll({ include: Customer });

// Hot reporting path: raw SQL where you control every line
const rows = await db.query(
  `SELECT c.name, SUM(o.total) AS revenue
     FROM orders o JOIN customers c ON c.id = o.customer_id
    WHERE o.created_at >= $1
    GROUP BY c.name
    ORDER BY revenue DESC
    LIMIT 20`,
  [since]   // still parameterized - never string-concatenate user input
);
```

## 7. Mental Model

> An ORM is an automatic gearbox: great for daily driving, but you should still know how the engine works, and switch to manual (raw SQL) on the steep hills.

## 8. Trade-offs

| | ORM | Raw SQL / query builder |
|---|---|---|
| Speed of development | Fast for CRUD | Slower, more code |
| Performance control | Limited, can surprise you | Full control |
| Injection safety | Safe by default | Safe only if parameterized |
| Complex queries | Awkward or inefficient | Natural |

## 9. Common Mistakes

- Banning the ORM entirely and then hand-writing string-concatenated SQL that opens SQL injection holes.
- Using the ORM everywhere without ever looking at the generated SQL.

## 10. 🧠 Remember

> The right answer isn't "never ORM" or "always ORM" - it's ORM for simple CRUD, raw SQL for complex and hot paths, and always knowing what SQL is actually running.

## 11. Quick Self-Test

1. What is the N+1 query problem, and how do you fix it inside an ORM?
2. Why can banning ORMs make an application *less* secure?
3. Which kinds of queries would you always write by hand?
