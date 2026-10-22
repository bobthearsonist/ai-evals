@suite:git-commit-style
Feature: Commit message suggestions

  @case:explicit-positive @should-trigger
  Scenario: Suggest a commit message for a rename
    When the user asks:
      """
      Write me a commit message: renamed getUser to fetchUser, updated 3 call sites.
      """
    Then the commit subject uses a conventional header with types "feat,fix,refactor" named "header"
    And the commit subject description starts with a lowercase letter named "lowercase"
    And the commit subject is shorter than 72 characters named "length"
