# Dependabot waits 14 days for actions too (#586)

- **The github-actions entry gets the same 14-day cooldown as npm.** The automation skill already says a new or bumped action pin must be a release at least 14 days old. The earlier config said the rule was only about npm, which was wrong: #607 bumped `anthropics/claude-code-action` to a release four days old and was closed for it. With the cooldown, Dependabot only offers pins that meet the rule. Security updates still arrive at once, as for npm, and the review decides whether to take one early.
