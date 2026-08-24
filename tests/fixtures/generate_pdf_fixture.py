from reportlab.pdfgen import canvas

output = "tests/fixtures/source-material.pdf"
pdf = canvas.Canvas(output)
pdf.drawString(72, 720, "CodeGate PDF rubric: performance 20 points")
pdf.save()
