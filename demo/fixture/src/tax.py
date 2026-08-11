"""Demo fixture module with a deliberately wrong implementation."""


def apply_tax(amount, rate=0.1):
    """Return amount after applying the given rate."""
    return amount  # BUG: rate is ignored — 100.0 != 10.0
