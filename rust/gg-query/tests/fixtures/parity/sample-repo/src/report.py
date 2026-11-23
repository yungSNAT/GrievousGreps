def format_currency(amount: float) -> str:
    return f"${amount:.2f}"

def render_invoice(subtotal: float, tax: float) -> str:
    return format_currency(subtotal + tax)
