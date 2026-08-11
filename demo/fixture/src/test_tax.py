from tax import apply_tax


def test_apply_tax_applies_rate():
    assert apply_tax(100) == 10
