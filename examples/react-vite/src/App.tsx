import { useState } from "react";
import { useInteractions } from "@codepress/interactions-react";
import { interactionOptions } from "./interactions";

interface Plan {
  id: string;
  name: string;
  price: string;
  features: string[];
  cta: string;
  featured?: boolean;
}

const PLANS: Plan[] = [
  {
    id: "free",
    name: "Free",
    price: "$0",
    features: ["3 notebooks", "Sync on 2 devices", "Markdown export"],
    cta: "Get started",
  },
  {
    id: "pro",
    name: "Pro",
    price: "$8",
    features: ["Unlimited notebooks", "Sync on every device", "Shared workspaces"],
    cta: "Start free trial",
    featured: true,
  },
];

export function App() {
  useInteractions(interactionOptions);
  const [chosen, setChosen] = useState<Plan | null>(null);

  return (
    <>
      <header className="site-header" data-testid="site-header">
        <span className="logo">Example Notes</span>
        <button className="link-button" data-testid="sign-in" type="button">
          Sign in
        </button>
      </header>

      <main className="pricing" data-testid="pricing">
        <h1>Pick a plan</h1>
        <p className="lede">Start free. Upgrade when your notes outgrow it.</p>

        <div className="plans">
          {PLANS.map((plan) => (
            <article
              key={plan.id}
              className={plan.featured ? "plan plan--featured" : "plan"}
              data-testid={`plan-${plan.id}`}
            >
              {plan.featured && (
                <span className="plan-badge" data-testid={`plan-${plan.id}-badge`}>
                  Most popular
                </span>
              )}
              <h2>{plan.name}</h2>
              <p className="plan-price">
                {plan.price}
                <span> / month</span>
              </p>
              <ul className="plan-features">
                {plan.features.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
              <button
                className="plan-cta"
                data-testid={`plan-${plan.id}-cta`}
                type="button"
                onClick={() => setChosen(plan)}
              >
                {plan.cta}
              </button>
            </article>
          ))}
        </div>

        <p className="status" role="status" data-testid="status">
          {chosen ? `${chosen.name} selected. We sent a confirmation link to your inbox.` : ""}
        </p>
      </main>
    </>
  );
}
