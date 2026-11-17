[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $FilePath,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $Email,

    [uri] $Url = "http://localhost:3000/api/v1/public/catalogs",

    [string] $Name
)

$ErrorActionPreference = "Stop"

if (-not $Url.IsAbsoluteUri -or $Url.UserInfo -or
    ($Url.Scheme -ne "https" -and -not ($Url.Scheme -eq "http" -and $Url.IsLoopback))) {
    throw "Use an HTTPS URL without embedded credentials, or HTTP on localhost for development."
}
if ($Email.Contains(":")) {
    throw "Email must not contain a colon."
}

$file = Get-Item -LiteralPath $FilePath
if ($file.PSIsContainer) {
    throw "FilePath must refer to a PDF file, not a directory."
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
$form = [System.Net.Http.MultipartFormDataContent]::new()
try {
    $client.Timeout = [TimeSpan]::FromMinutes(10)
    $client.DefaultRequestHeaders.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new("Basic", $authorization)
    $client.DefaultRequestHeaders.Add("X-Catalog-Upload", "1")
    $authorization = $null

    $stream = [System.IO.File]::OpenRead($file.FullName)
    $fileContent = [System.Net.Http.StreamContent]::new($stream)
    $fileContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::new("application/pdf")
    $form.Add($fileContent, "file", $file.Name)
    if ($PSBoundParameters.ContainsKey("Name")) {
        $form.Add([System.Net.Http.StringContent]::new($Name), "name")
    }

    $response = $client.PostAsync($Url, $form).GetAwaiter().GetResult()
    try {
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) {
            if ($body) {
                [Console]::Error.WriteLine($body)
            }
            throw "Catalog upload failed with HTTP $([int] $response.StatusCode)."
        }
        Write-Output $body
    } finally {
        $response.Dispose()
    }
} finally {
    $form.Dispose()
    $client.Dispose()
}
