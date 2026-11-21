[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, ParameterSetName = "Single")]
    [ValidateNotNullOrEmpty()]
    [string] $FilePath,

    [Parameter(Mandatory = $true, ParameterSetName = "Csv")]
    [ValidateNotNullOrEmpty()]
    [string] $CsvPath,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $Email,

    [uri] $Url = "http://localhost:3000/api/v1/public/catalogs",

    [Parameter(ParameterSetName = "Single")]
    [string] $Name,

    [Parameter(ParameterSetName = "Csv")]
    [string] $LogPath
)

$ErrorActionPreference = "Stop"

if (-not $Url.IsAbsoluteUri -or $Url.UserInfo -or
    ($Url.Scheme -ne "https" -and -not ($Url.Scheme -eq "http" -and $Url.IsLoopback))) {
    throw "Use an HTTPS URL without embedded credentials, or HTTP on localhost for development."
}
if ($Email.Contains(":")) {
    throw "Email must not contain a colon."
}

$failureCount = 0
$failureLogPath = $null
$isCsvMode = $PSCmdlet.ParameterSetName -eq "Csv"

function Write-CatalogUploadFailure {
    param(
        [string] $Path,
        [string] $Message
    )

    $script:failureCount++
    if (-not $script:failureLogPath) {
        if ($LogPath) {
            $script:failureLogPath = $LogPath
        } else {
            $logDirectory = if ($isCsvMode) {
                Split-Path -Parent (Get-Item -LiteralPath $CsvPath).FullName
            } else {
                Split-Path -Parent (Get-Item -LiteralPath $FilePath).FullName
            }
            $script:failureLogPath = Join-Path $logDirectory "upload-catalog-failures-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
        }
    }

    $entry = "[{0}] {1}: {2}" -f (Get-Date -Format "o"), $Path, $Message
    Add-Content -LiteralPath $script:failureLogPath -Value $entry
    [Console]::Error.WriteLine($entry)
}

function Get-CatalogUpload {
    param(
        [string] $Path,
        [string] $CatalogName
    )

    $item = Get-Item -LiteralPath $Path
    if ($item.PSIsContainer) {
        throw "PDF path '$Path' refers to a directory."
    }
    [pscustomobject] @{
        File = $item
        Name = $CatalogName
        HasName = -not [string]::IsNullOrWhiteSpace($CatalogName)
    }
}

$uploads = @()
if ($PSCmdlet.ParameterSetName -eq "Single") {
    $uploads += Get-CatalogUpload -Path $FilePath -CatalogName $Name
} else {
    $csvFile = Get-Item -LiteralPath $CsvPath
    if ($csvFile.PSIsContainer) {
        throw "CsvPath must refer to a CSV file, not a directory."
    }

    $rows = @(Import-Csv -LiteralPath $csvFile.FullName)
    if ($rows.Count -eq 0) {
        throw "CSV file must contain a FilePath header and at least one data row."
    }

    $headers = @($rows[0].PSObject.Properties.Name)
    if ($headers -notcontains "FilePath") {
        throw "CSV file must contain a FilePath column."
    }

    $unsupportedHeaders = @($headers | Where-Object { $_ -ne "FilePath" -and $_ -ne "Name" })
    if ($unsupportedHeaders.Count -gt 0) {
        throw "Unsupported CSV column(s): $($unsupportedHeaders -join ', '). Use FilePath and optional Name."
    }

    foreach ($row in $rows) {
        $pdfPath = $row.FilePath
        if ([string]::IsNullOrWhiteSpace($pdfPath)) {
            Write-CatalogUploadFailure -Path "CSV row $($uploads.Count + $failureCount + 1)" -Message "FilePath is empty."
            continue
        }
        if (-not [System.IO.Path]::IsPathRooted($pdfPath)) {
            $pdfPath = Join-Path $csvFile.Directory.FullName $pdfPath
        }
        try {
            $uploads += Get-CatalogUpload -Path $pdfPath -CatalogName $row.Name
        } catch {
            Write-CatalogUploadFailure -Path $pdfPath -Message $_.Exception.Message
        }
    }
}

if ($uploads.Count -eq 0 -and $failureCount -gt 0) {
    throw "$failureCount catalog upload(s) failed validation. See $failureLogPath."
}

Add-Type -AssemblyName System.Net.Http

$securePassword = Read-Host -Prompt "Password for $Email" -AsSecureString
try {
    $password = [System.Net.NetworkCredential]::new("", $securePassword).Password
    $credentialBytes = [System.Text.Encoding]::UTF8.GetBytes("${Email}:${password}")
    $authorization = [Convert]::ToBase64String($credentialBytes)
} finally {
    $securePassword.Dispose()
    $password = $null
    if ($credentialBytes) {
        [Array]::Clear($credentialBytes, 0, $credentialBytes.Length)
    }
}

$handler = [System.Net.Http.HttpClientHandler]::new()
$handler.AllowAutoRedirect = $false
$client = [System.Net.Http.HttpClient]::new($handler)
try {
    $client.Timeout = [TimeSpan]::FromMinutes(10)
    $client.DefaultRequestHeaders.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new("Basic", $authorization)
    $client.DefaultRequestHeaders.Add("X-Catalog-Upload", "1")
    $authorization = $null

    for ($index = 0; $index -lt $uploads.Count; $index++) {
        $upload = $uploads[$index]
        Write-Host "Uploading $($index + 1) of $($uploads.Count): $($upload.File.FullName)"

        $form = [System.Net.Http.MultipartFormDataContent]::new()
        $stream = $null
        try {
            $stream = [System.IO.File]::OpenRead($upload.File.FullName)
            $fileContent = [System.Net.Http.StreamContent]::new($stream)
            $fileContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::new("application/pdf")
            $form.Add($fileContent, "file", $upload.File.Name)
            if ($upload.HasName) {
                $form.Add([System.Net.Http.StringContent]::new($upload.Name), "name")
            }

            $response = $client.PostAsync($Url, $form).GetAwaiter().GetResult()
            try {
                $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
                if (-not $response.IsSuccessStatusCode) {
                    if ($body) {
                        [Console]::Error.WriteLine($body)
                    }
                    throw "HTTP $([int] $response.StatusCode): $body"
                }
                Write-Output $body
            } finally {
                $response.Dispose()
            }
        } catch {
            Write-CatalogUploadFailure -Path $upload.File.FullName -Message $_.Exception.Message
        } finally {
            $form.Dispose()
            if ($stream) {
                $stream.Dispose()
            }
        }
    }
} finally {
    $client.Dispose()
}

if ($failureCount -gt 0) {
    throw "$failureCount catalog upload(s) failed. See $failureLogPath."
}
