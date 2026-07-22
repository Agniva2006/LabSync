import 'dart:io';
import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:csv/csv.dart';
import '../../core/constants.dart';
import '../../widgets/glass_card.dart';
import '../../services/api_service.dart';
import 'dart:convert';

class BulkImportScreen extends StatefulWidget {
  const BulkImportScreen({super.key});

  @override
  State<BulkImportScreen> createState() => _BulkImportScreenState();
}

class _BulkImportScreenState extends State<BulkImportScreen> {
  final ApiService _apiService = ApiService();
  File? _selectedFile;
  List<List<dynamic>> _previewData = [];
  bool _isLoading = false;
  String _statusMessage = '';
  int _importedCount = 0;
  int _totalCount = 0;
  List<String> _errors = [];

  Future<void> _pickCSVFile() async {
    try {
      FilePickerResult? result = await FilePicker.platform.pickFiles(
        type: FileType.custom,
        allowedExtensions: ['csv'],
      );

      if (result != null && result.files.single.path != null) {
        setState(() {
          _selectedFile = File(result.files.single.path!);
          _previewData = [];
          _statusMessage = '';
          _errors = [];
        });

        await _parseAndPreviewCSV();
      }
    } catch (e) {
      setState(() {
        _statusMessage = 'Error picking file: $e';
      });
    }
  }

  Future<void> _parseAndPreviewCSV() async {
    if (_selectedFile == null) return;

    try {
      final input = _selectedFile!.openRead();
      final fields = await input
          .transform(Utf8Decoder())
          .transform(const CsvToListConverter())
          .toList();

      setState(() {
        _previewData = fields;
        _totalCount = fields.length - 1; // Exclude header
        _statusMessage = 'Preview: ${_totalCount} users found';
      });
    } catch (e) {
      setState(() {
        _statusMessage = 'Error parsing CSV: $e';
      });
    }
  }

  Future<void> _startImport() async {
    if (_previewData.isEmpty || _previewData.length < 2) {
      setState(() {
        _statusMessage = 'No valid data to import';
      });
      return;
    }

    setState(() {
      _isLoading = true;
      _statusMessage = 'Importing users...';
      _errors = [];
    });

    try {
      // Parse CSV data to list of user maps
      List<Map<String, dynamic>> usersToImport = [];

      // Skip header row (index 0)
      for (int i = 1; i < _previewData.length; i++) {
        final row = _previewData[i];

        if (row.length >= 2) {
          // At least name and email
          usersToImport.add({
            'name': row.length > 0 ? row[0].toString().trim() : '',
            'email': row.length > 1 ? row[1].toString().trim() : '',
            'password':
                row.length > 2 ? row[2].toString().trim() : 'default123',
            'department': row.length > 3 ? row[3].toString().trim() : '',
            'role': row.length > 4 ? row[4].toString().trim() : 'user',
            'authorized_rooms': row.length > 5 ? row[5].toString().trim() : '',
            'fingerprint_id': row.length > 6 ? row[6].toString().trim() : '',
          });
        }
      }

      // Call backend API
      final result = await _apiService.bulkImportUsers(usersToImport);

      setState(() {
        _isLoading = false;

        if (result['success'] == true) {
          _importedCount = result['importedCount'] ?? 0;
          _totalCount = result['total'] ?? 0;
          _errors = result['errors'] != null
              ? List<String>.from(result['errors'])
              : [];
          _statusMessage = result['message'];
        } else {
          _statusMessage = result['message'] ?? 'Import failed';
        }
      });

      if (!mounted) return;

      showDialog(
        context: context,
        builder: (context) => AlertDialog(
          backgroundColor: AppColors.surfaceDark,
          title: const Text(
            'Import Complete',
            style: TextStyle(color: AppColors.textPrimary),
          ),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                _statusMessage,
                style: const TextStyle(color: AppColors.textSecondary),
              ),
              if (_errors.isNotEmpty) ...[
                const SizedBox(height: 16),
                const Text(
                  'Errors:',
                  style: TextStyle(
                    color: AppColors.danger,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 8),
                SizedBox(
                  height: 150,
                  child: ListView.builder(
                    itemCount: _errors.length,
                    itemBuilder: (context, index) => Padding(
                      padding: const EdgeInsets.symmetric(vertical: 2),
                      child: Text(
                        _errors[index],
                        style: const TextStyle(
                          color: AppColors.textSecondary,
                          fontSize: 12,
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Close'),
            ),
          ],
        ),
      );
    } catch (e) {
      setState(() {
        _isLoading = false;
        _statusMessage = 'Import failed: $e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bgDark,
      appBar: AppBar(
        title: const Text('BULK IMPORT USERS'),
        backgroundColor: AppColors.neonCyan.withOpacity(0.2),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Instructions Card
            GlassCard(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'CSV FORMAT',
                    style: TextStyle(
                      color: AppColors.neonCyan,
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                      letterSpacing: 2,
                    ),
                  ),
                  const SizedBox(height: 16),
                  const Text(
                    'Required columns (in order):',
                    style: TextStyle(color: AppColors.textSecondary),
                  ),
                  const SizedBox(height: 8),
                  _buildInstructionRow('1', 'Name', 'John Doe'),
                  _buildInstructionRow('2', 'Email', 'john@iit.edu'),
                  _buildInstructionRow('3', 'Password', 'pass123 (optional)'),
                  _buildInstructionRow('4', 'Department', 'Computer Science'),
                  _buildInstructionRow('5', 'Role', 'user or admin'),
                  _buildInstructionRow(
                      '6', 'Authorized Rooms', 'ROOM-001,ROOM-002'),
                  _buildInstructionRow(
                      '7', 'Fingerprint ID', '1 (from sensor)'),
                  const SizedBox(height: 16),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: AppColors.neonCyan.withOpacity(0.1),
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(
                          color: AppColors.neonCyan.withOpacity(0.3)),
                    ),
                    child: const Text(
                      '💡 Tip: Download sample CSV from admin panel',
                      style: TextStyle(
                        color: AppColors.neonCyan,
                        fontSize: 12,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),

            // Upload Button
            ElevatedButton.icon(
              onPressed: _isLoading ? null : _pickCSVFile,
              icon: const Icon(Icons.upload_file),
              label: Text(
                  _selectedFile == null ? 'SELECT CSV FILE' : 'CHANGE FILE'),
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.neonCyan,
                foregroundColor: AppColors.bgDark,
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
            ),
            const SizedBox(height: 16),

            // File Info
            if (_selectedFile != null)
              GlassCard(
                padding: const EdgeInsets.all(16),
                child: Row(
                  children: [
                    Icon(Icons.insert_drive_file, color: AppColors.neonCyan),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            _selectedFile!.path.split('/').last,
                            style: const TextStyle(
                              color: AppColors.textPrimary,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          Text(
                            'Size: ${(_selectedFile!.lengthSync() / 1024).toStringAsFixed(1)} KB',
                            style: TextStyle(
                              color: AppColors.textSecondary,
                              fontSize: 12,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            const SizedBox(height: 24),

            // Preview Section
            if (_previewData.isNotEmpty) ...[
              GlassCard(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(
                          'PREVIEW (${_previewData.length - 1} users)',
                          style: TextStyle(
                            color: AppColors.textSecondary,
                            fontSize: 12,
                            letterSpacing: 2,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 12,
                            vertical: 4,
                          ),
                          decoration: BoxDecoration(
                            color: AppColors.warning.withOpacity(0.2),
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: Text(
                            '${_previewData.length - 1} ROWS',
                            style: TextStyle(
                              color: AppColors.warning,
                              fontSize: 11,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    // Table Header
                    Container(
                      padding: const EdgeInsets.all(8),
                      decoration: BoxDecoration(
                        color: AppColors.neonCyan.withOpacity(0.1),
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: Row(
                        children: [
                          Expanded(child: _buildHeaderCell('NAME')),
                          Expanded(child: _buildHeaderCell('EMAIL')),
                          Expanded(child: _buildHeaderCell('ROLE')),
                        ],
                      ),
                    ),
                    const SizedBox(height: 8),
                    // Preview first 3 rows
                    ..._previewData.skip(1).take(3).map((row) => Padding(
                          padding: const EdgeInsets.only(bottom: 4),
                          child: Row(
                            children: [
                              Expanded(
                                child: Text(
                                  row.length > 0 ? row[0].toString() : '',
                                  style: const TextStyle(
                                    color: AppColors.textPrimary,
                                    fontSize: 12,
                                  ),
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                              Expanded(
                                child: Text(
                                  row.length > 1 ? row[1].toString() : '',
                                  style: const TextStyle(
                                    color: AppColors.textSecondary,
                                    fontSize: 12,
                                  ),
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                              Expanded(
                                child: Text(
                                  row.length > 4 ? row[4].toString() : 'user',
                                  style: const TextStyle(
                                    color: AppColors.textSecondary,
                                    fontSize: 12,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        )),
                    if (_previewData.length > 4)
                      Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Text(
                          '... and ${_previewData.length - 4} more',
                          style: TextStyle(
                            color: AppColors.textMuted,
                            fontSize: 12,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: 24),
            ],

            // Import Button
            if (_previewData.isNotEmpty && _previewData.length > 1)
              ElevatedButton.icon(
                onPressed: _isLoading ? null : _startImport,
                icon: _isLoading
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: AppColors.bgDark,
                        ),
                      )
                    : const Icon(Icons.person_add),
                label: Text(_isLoading
                    ? 'IMPORTING...'
                    : 'IMPORT ${_previewData.length - 1} USERS'),
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.success,
                  foregroundColor: AppColors.bgDark,
                  padding: const EdgeInsets.symmetric(vertical: 16),
                ),
              ),

            // Status Message
            if (_statusMessage.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 16),
                child: Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: _errors.isNotEmpty
                        ? AppColors.danger.withOpacity(0.1)
                        : AppColors.success.withOpacity(0.1),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: _errors.isNotEmpty
                          ? AppColors.danger.withOpacity(0.3)
                          : AppColors.success.withOpacity(0.3),
                    ),
                  ),
                  child: Text(
                    _statusMessage,
                    style: TextStyle(
                      color: _errors.isNotEmpty
                          ? AppColors.danger
                          : AppColors.success,
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildInstructionRow(String num, String field, String example) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Container(
            width: 24,
            height: 24,
            decoration: BoxDecoration(
              color: AppColors.neonCyan.withOpacity(0.2),
              borderRadius: BorderRadius.circular(4),
            ),
            child: Center(
              child: Text(
                num,
                style: TextStyle(
                  color: AppColors.neonCyan,
                  fontSize: 12,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: RichText(
              text: TextSpan(
                style: const TextStyle(fontSize: 12),
                children: [
                  TextSpan(
                    text: '$field: ',
                    style: const TextStyle(
                      color: AppColors.textPrimary,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  TextSpan(
                    text: example,
                    style: TextStyle(color: AppColors.textSecondary),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildHeaderCell(String text) {
    return Text(
      text,
      style: const TextStyle(
        color: AppColors.neonCyan,
        fontSize: 10,
        fontWeight: FontWeight.bold,
        letterSpacing: 1,
      ),
      textAlign: TextAlign.center,
    );
  }
}
