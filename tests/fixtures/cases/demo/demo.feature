Feature: Demo skill activation
  @case:explicit-positive @should-trigger
  Scenario: Explicit skill request
    When the user asks:
      """
      Use the demo skill to greet me.
      """
    Then the response matches regex named "greeting" with flags "":
      """
      hello
      """

  @case:implicit-positive @should-trigger
  Scenario: Implicit greeting request
    When the user asks:
      """
      Give me a greeting.
      """
    Then the response matches regex named "greeting" with flags "":
      """
      hello
      """

  @case:negative-control @should-not-trigger
  Scenario: Unrelated farewell
    When the user asks:
      """
      Say goodbye.
      """
    Then the response matches regex named "farewell" with flags "":
      """
      goodbye
      """
