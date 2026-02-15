# Helper script to update dynamic-security.json from .new file
# Run this after making changes with mosquitto_ctrl

$newFile = "dynamic-security.json.new"
$mainFile = "dynamic-security.json"

if (Test-Path $newFile) {
    Copy-Item $newFile $mainFile -Force
    Remove-Item $newFile -Force
    Write-Host "Updated $mainFile and removed .new file" -ForegroundColor Green
} else {
    Write-Host "No .new file found" -ForegroundColor Yellow
}

